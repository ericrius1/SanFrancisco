import * as THREE from "three/webgpu";
import { Policy } from "./policy.ts";
import type { Projection, RoadGraph } from "./roadGraph.ts";
import { ACTOR_SIZES, type CarBrainBlob } from "./learner.ts";

// Net shape is sourced from learner.ts now that the GA trainer.ts is
// gone. Named CAR_SIZES locally so the existing sim/overlay code is untouched.
const CAR_SIZES = ACTOR_SIZES;

/**
 * Fleet — the AI cars as PERSISTENT INDIVIDUALS (continual-learning rewrite).
 *
 * Every car is placed ONCE at world init on a random road point in a wide radius
 * around the first anchor, then lives forever: it keeps its id, body, paint, and
 * its own online-learning brain. There are no episodes, no fitness reports, no
 * teleports, no respawns, no despawn-by-distance. The former GA ontology
 * (Trainer/genomes/generations) is gone — a `Learner` (see interface below,
 * implemented in learner.ts) owns the actor-critic nets and does an online update
 * every learn tick. The fleet drives control every substep and passes each
 * learn-tick transition + shaped reward to the learner.
 *
 * HEADING CONVENTION (used everywhere below):
 *   heading = 0 points toward +Z. The forward unit vector is
 *       fwd = (sin(heading), cos(heading))
 *   and the left-hand normal of a road tangent (tx, tz) is (-tz, tx), so a
 *   positive `lateral` from RoadGraph.project means "to the left of travel".
 *   heading is recovered from a direction (dx, dz) by atan2(dx, dz).
 *
 * REVERSE: speed ∈ [SPEED_MIN, SPEED_MAX] = [-4, 14] m/s. A car integrates its
 * position along heading × speed, so a negative speed backs it up; the kinematic
 * bicycle yaw rate is proportional to signed speed, so the steering geometry
 * flips naturally when reversing (backing out of a corner is learnable).
 *
 * DISTANCE TIERS (relative to the nearest anchor, hysteresis 380/420 m):
 *   NEAR — a kinematic physics body exists, clearance from real building sweeps
 *          and a car-vs-car forward cone.
 *   FAR  — no physics body (created/destroyed across the boundary through the
 *          onWillRemoveBody contract); the SAME obs slots are filled by
 *          road-based estimates (clearAhead from lookAhead path divergence /
 *          segment-end proximity; clearLeft/Right from lateral road-edge margin).
 * Sim + learning run at full rate in BOTH tiers, city-wide, forever.
 *
 * All world access goes through the injected `FleetWorld` so the sim runs
 * headless in Node (stub flat ground + clear sweeps) exactly as in the browser.
 */

// --- injected world interface (browser adapts Physics+WorldMap into this) ----
export interface FleetWorld {
  /** Effective ground height (terrain or bridge deck) at (x, z). */
  ground(x: number, z: number): number;
  /** Is (x, z) open water? */
  isWater(x: number, z: number): boolean;
  /**
   * First building hit along the segment p0→p1: distance from p0 to the hit
   * (metres), or null if the segment is clear.
   */
  sweep(p0: [number, number, number], p1: [number, number, number]): number | null;
  /** Create a kinematic car body; returns a handle. */
  createBody(x: number, y: number, z: number, hx: number, hy: number, hz: number, heading: number): number;
  /** Move a body to a pose (position + quaternion). */
  moveBody(handle: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void;
  /** Destroy a body. */
  removeBody(handle: number): void;
}

// --- the learner contract (implemented in learner.ts, Wave A) ----------------
//
// LOCKED interface (plan §Waves). The fleet owns none of the RL math; it only
// feeds transitions and reads skill. `actorForward` writes the SAMPLED action
// (mean + exploration noise) into `out` for control every substep; `learnStep`
// runs the online update on a learn-tick transition; `syncPolicy` mirrors the
// canonical actor weights into the car's Policy purely so the existing overlay
// render path keeps working unmodified.

/**
 * The learner's public surface the fleet drives. Matches learner.ts's `class
 * Learner` exactly (structural), so the real Learner is assignable here while the
 * fleet stays decoupled + testable against a mock. `reward` in learnStep is the
 * per-SECOND reward RATE at that learn tick (a rate in ~m/s units), NOT the
 * dt-integrated value — see learner.ts's REWARD CONVENTION. `lessonCheck()`
 * computes the fleet-wide skill stats itself and returns the ids it lessoned.
 */
export interface Learner {
  /** Sampled action (mean + Gaussian noise) for control this substep → `out`. */
  actorForward(i: number, obs: Float32Array, out: Float32Array): void;
  /** Online update on a learn-tick transition; `reward` is a per-second rate. */
  learnStep(i: number, obs: Float32Array, action: Float32Array, reward: number, nextObs: Float32Array): void;
  /** Rolling skill (reward-rate EMA, per minute) for car i — HUD + lesson stats. */
  skill(i: number): number;
  /** Accumulate |ds| metres into car i's odometer. */
  addOdometer(i: number, ds: number): void;
  /** Anti-collapse social rescue check (called ~every 30 s); returns lessoned ids. */
  lessonCheck(): number[];
  /** Export car i's brain fields (fleet merges with its own identity/pose). */
  exportCar(i: number): CarBrainBlob;
  /** Restore car i's brain from a blob; returns whether it validated. */
  importCar(i: number, blob: CarBrainBlob): boolean;
  /** Reset car i to a fresh individual (uncovered slot on a partial restore). */
  resetCar(i: number): void;
  /** Mirror canonical actor weights into a Policy (overlay path only, ≤ 5 Hz). */
  syncPolicy(i: number, policy: Policy): void;
}

// --- the AiCar shape (persistent individual + internal bookkeeping) -----------
export type AiCar = {
  id: number; // stable slot index 0..MAX_CARS-1 (identity, never rerolled)
  policy: Policy; // overlay mirror only; learner.syncPolicy writes into it
  pos: THREE.Vector3; // world position (wheel-contact centre)
  heading: number; // yaw radians, 0 = +Z (see convention above)
  speed: number; // signed m/s along heading (negative = reversing)
  steer: number; // last steer action[0], for wheel visuals
  bodyKind: number; // 0..N-1 → which carMesh variant (identity)
  paintHue: number; // 0..1 (identity)
  mesh?: THREE.Group; // attached by index.ts
  /**
   * Always true after init. Retained (never toggled false during life) so the
   * unmodified index.ts / netSync.ts render+serialize paths keep compiling and
   * treating every slot as a live car. It now means "initialized", not "alive
   * this episode" — there are no episodes.
   */
  alive: boolean;
  lastObs: Float32Array; // most recent observation vector (for the brain overlay)
  // --- internal ---
  tier: number; // 0 = FAR (no body), 1 = NEAR (physics body)
  bodyHandle: number; // physics body handle (0 = none)
  prevX: number; // last-step position, for forward-progress reward
  prevZ: number;
  prevSteer: number; // last steer, for steer-smoothness reward
  prevHeading: number; // last-step heading, for the sustained-yaw penalty
  travelDir: 1 | -1; // COMMITTED road direction (see stepCar) — re-anchored by NET distance
  commitSeg: number; // segId travelDir was committed for (-1 = uncommitted)
  commitX: number; // position where travelDir was last committed (net-distance gate)
  commitZ: number;
  stuckT: number; // seconds continuously |speed| < STUCK_SPEED
  wrongWayT: number; // seconds continuously facing against a one-way street
  carContactCooldown: number; // seconds before the next car-contact episode can be counted
  safeX: number; // last verified non-water road pose for recovery
  safeZ: number;
  safeHeading: number;
  rewardAccum: number; // integrated reward summed across the current learn window
  windowDt: number; // elapsed seconds across the current learn window (→ rate)
  windowOpen: boolean; // a learn window has been opened (guards the first tick)
  learnObs: Float32Array; // obs snapshot at the current window's start
  learnAction: Float32Array; // sampled action at the current window's start
};

// --- persistence blob (LOCKED format v:3) ------------------------------------
export type CarBlob = CarBrainBlob & {
  id: number;
  bodyKind: number;
  paintHue: number;
  x: number;
  z: number;
  heading: number;
  speed?: number;
};
export interface FleetBlob {
  v: 3;
  born: number; // epoch ms the world was first born
  cars: CarBlob[];
}

// --- tunables ---------------------------------------------------------------
export const MAX_CARS = 48;
const SPEED_MAX = 14; // m/s forward cap
const SPEED_MIN = -4; // m/s reverse cap
const ACCEL_FWD = 4; // m/s² for a positive accel command
const ACCEL_BRAKE = 6; // m/s² for a negative command (brake / reverse-accel)
const MAX_STEER_ANGLE = 0.5; // rad, front-wheel angle at full steer
const WHEELBASE = 3.0; // m, kinematic bicycle wheelbase
const RIDE_HEIGHT = 0.85; // sedan profile
const HALF_EXTENTS: [number, number, number] = [1.05, 0.45, 2.2];
const AHEAD_RANGE = 25; // clearAhead probe (m)
const SIDE_RANGE = 10; // clearLeft/Right probes (m)
const SIDE_ANGLE = 0.61; // ±35°
const SIGNAL_RANGE = 55; // metres ahead for traffic-light observation
// Cars are scattered city-wide, decoupled from the player — the city is alive
// whether or not anyone is watching; you simply stumble on them as you explore.
// Placement is restricted to the loaded-city extent (public/data/meta.json grid)
// so cars land where players actually go, not on far-flung OSM freeways.
const CITY_MIN_X = -7168;
const CITY_MAX_X = 7936;
const CITY_MIN_Z = -8896;
const CITY_MAX_Z = 4992;
const NEAR_R = 380; // m, FAR→NEAR body-create boundary (hysteresis low)
const FAR_R = 420; // m, NEAR→FAR body-destroy boundary (hysteresis high)
const STUCK_SPEED = 0.3; // m/s, below which the stuck timer accrues
const STUCK_TIME = 5; // s continuously stuck before the stuck penalty applies
const LEARN_EVERY = 3; // substeps per learn tick (20 Hz at 60 Hz substeps)
const SYNC_INTERVAL = 0.2; // s between overlay policy syncs (≤ 5 Hz)
const LESSON_INTERVAL = 30; // s between social-rescue lesson checks
const ROAD_EDGE_FRACTION = 0.88; // physical training guard: stay inside the paved envelope
const ROAD_RECOVERY_SPEED_DAMP = 0.35; // lose speed when the road envelope catches you
const WRONG_WAY_FACE_DOT = -0.05; // start recovery before a one-way car is fully backwards
const WRONG_WAY_PENALTY_DOT = -0.15; // count only clear wrong-way motion as a training violation
const WRONG_WAY_RECOVERY_TIME = 2.5; // seconds before a one-way street forces a safe reorientation
const CAR_FOOTPRINT_SIDE = HALF_EXTENTS[0] * 2 + 0.35; // centre-to-centre side clearance for car bodies
const CAR_FOOTPRINT_ALONG = HALF_EXTENTS[2] * 2 + 0.55; // centre-to-centre nose/tail clearance for car bodies
const CAR_BRAKE_SIDE = CAR_FOOTPRINT_SIDE + 0.55;
const CAR_BRAKE_ALONG = CAR_FOOTPRINT_ALONG + 3.0;
const CAR_CAUTION_CLEAR = 0.82;
const CAR_STOP_GAP = CAR_FOOTPRINT_ALONG + 1.8;
const CAR_HARD_SIDE = HALF_EXTENTS[0] * 2;
const CAR_HARD_ALONG = HALF_EXTENTS[2] * 2;
const CAR_CONTACT_COOLDOWN = 1.25;
const CAR_SETTLE_DIST = 4.05;
const CAR_SETTLE_DIST2 = CAR_SETTLE_DIST * CAR_SETTLE_DIST;

// reward shaping (per-second rates; multiplied by dt in the hot loop)
const R_OFFROAD = 0.5;
const R_GRIND = 2.0;
const R_STEER = 0.02;
const R_REVERSE = 0.3;
const R_STUCK = 1.0;
const R_LANE = 0.35;
const R_WRONG_WAY = 2.5;
const R_CLOSE_FOLLOW = 1.1;
const R_COLLISION = 5.0;
const R_ROAD_CLAMP = 0.9;
const R_RED_LIGHT = 5.0;
const R_RED_APPROACH = 0.25;
const SIGNAL_STOP_BUFFER = 1.9; // metres before the stop line where non-green signals hold the car
// Sustained-yaw penalty. R_STEER only punishes CHANGING the steer, so a constant
// max-lock turn (a spin) paid nothing — this charges for actual heading change per
// second, so continuous spinning is costly while a one-off corner is cheap.
const R_YAW = 0.6;
// Net metres the car must translate before its committed road direction re-anchors.
// A spin never covers this ground, so its progress reward stays pinned at ≈0.
const COMMIT_DIST = 20;

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function laneCenterFor(proj: Projection, dir: 1 | -1): number {
  const lanes =
    proj.oneWayDir !== 0
      ? Math.max(1, proj.oneWayDir === 1 ? proj.forwardLanes || proj.lanes : proj.backwardLanes || proj.lanes)
      : Math.max(1, dir === 1 ? proj.forwardLanes || Math.ceil(proj.lanes / 2) : proj.backwardLanes || Math.floor(proj.lanes / 2));
  const laneW = (proj.oneWayDir !== 0 ? proj.halfWidth * 2 : proj.halfWidth) / lanes;
  return -dir * (proj.halfWidth - laneW * 0.5);
}

export class Fleet {
  cars: AiCar[] = [];
  /** Fires just BEFORE a car body is destroyed (index/main release hook). */
  onWillRemoveBody: (handle: number) => void = () => {};

  #world: FleetWorld;
  #roads: RoadGraph;
  #learner: Learner;
  #rng: () => number;
  #anchors: THREE.Vector3[] = [];
  #initialized = false;
  #born = 0;
  #substep = 0;
  #syncTimer = 0;
  #lessonTimer = LESSON_INTERVAL;
  #timeS = 0;
  #diag = {
    collisions: 0,
    buildingCollisions: 0,
    carCollisions: 0,
    waterHits: 0,
    roadClamps: 0,
    laneCorrections: 0,
    redLightViolations: 0,
    stopLineHolds: 0,
    offRoadSteps: 0,
    wrongWaySteps: 0,
    laneErrorSum: 0,
    distanceM: 0,
    forwardProgressM: 0,
    samples: 0
  };

  // reused scratch — the sim allocates nothing per step
  #obs = new Float32Array(CAR_SIZES[0]);
  #action = new Float32Array(CAR_SIZES[CAR_SIZES.length - 1]);
  #up = new THREE.Vector3(0, 1, 0);
  #nrm = new THREE.Vector3();
  #qYaw = new THREE.Quaternion();
  #qTilt = new THREE.Quaternion();

  constructor(world: FleetWorld, roads: RoadGraph, learner: Learner, rng: () => number = Math.random) {
    this.#world = world;
    this.#roads = roads;
    this.#learner = learner;
    this.#rng = rng;
    for (let i = 0; i < MAX_CARS; i++) {
      this.cars.push({
        id: i,
        policy: Policy.random([...CAR_SIZES], rng, "car"),
        pos: new THREE.Vector3(),
        heading: 0,
        speed: 0,
        steer: 0,
        bodyKind: 0,
        paintHue: 0,
        alive: false,
        lastObs: new Float32Array(CAR_SIZES[0]),
        tier: 0,
        bodyHandle: 0,
        prevX: 0,
        prevZ: 0,
        prevSteer: 0,
        prevHeading: 0,
        travelDir: 1,
        commitSeg: -1,
        commitX: 0,
        commitZ: 0,
        stuckT: 0,
        wrongWayT: 0,
        carContactCooldown: 0,
        safeX: 0,
        safeZ: 0,
        safeHeading: 0,
        rewardAccum: 0,
        windowDt: 0,
        windowOpen: false,
        learnObs: new Float32Array(CAR_SIZES[0]),
        learnAction: new Float32Array(CAR_SIZES[CAR_SIZES.length - 1])
      });
    }
  }

  /** The injected learner (index.ts reads skill/lesson stats through here). */
  get learner(): Learner {
    return this.#learner;
  }

  /** Rolling skill of car i (reward-rate EMA), for the HUD / index.ts. */
  skill(i: number): number {
    return this.#learner.skill(i);
  }

  /** Fixed-step control: place once, manage tiers, then sim every car. */
  prePhysics(dt: number, anchors: THREE.Vector3[]): void {
    this.#timeS += dt;
    this.#anchors = anchors;
    if (!this.#initialized) {
      if (anchors.length === 0) return; // wait for a real anchor to place around
      this.#placeAll();
      this.#initialized = true;
    }
    this.#manageTiers();

    const learnTick = this.#substep % LEARN_EVERY === 0;
    this.#substep++;
    for (const car of this.cars) this.#stepCar(car, dt, learnTick);
    this.#settleCarPairs();

    // overlay policy mirror (≤ 5 Hz)
    this.#syncTimer -= dt;
    if (this.#syncTimer <= 0) {
      this.#syncTimer = SYNC_INTERVAL;
      for (const car of this.cars) {
        this.#learner.syncPolicy(car.id, car.policy);
        // refresh layerOut so the overlay shows near-live activations (index.ts
        // only reads car.policy.layerOut; nothing else triggers a forward now).
        car.policy.forward(car.lastObs);
      }
    }

    // social-rescue lesson check (every 30 s). The learner owns the skill
    // distribution and decides which lagging cars get a mentor blend.
    this.#lessonTimer -= dt;
    if (this.#lessonTimer <= 0) {
      this.#lessonTimer = LESSON_INTERVAL;
      this.#learner.lessonCheck();
    }
  }

  /**
   * Continual learning has no generations. This shim keeps the shape index.ts's
   * (Wave C, not-yet-rewritten) HUD path expects: gen is meaningless (0);
   * best/mean are skill stats so nothing reads NaN.
   */
  stats(): { gen: number; bestFit: number; meanFit: number } {
    let best = -Infinity;
    let sum = 0;
    let n = 0;
    for (const car of this.cars) {
      const s = this.#learner.skill(car.id);
      if (Number.isFinite(s)) {
        if (s > best) best = s;
        sum += s;
        n++;
      }
    }
    return { gen: 0, bestFit: n ? best : 0, meanFit: n ? sum / n : 0 };
  }

  diagnostics(): {
    collisions: number;
    buildingCollisions: number;
    carCollisions: number;
    waterHits: number;
    roadClamps: number;
    laneCorrections: number;
    redLightViolations: number;
    stopLineHolds: number;
    offRoadSteps: number;
    wrongWaySteps: number;
    meanLaneError: number;
    distanceM: number;
    forwardProgressM: number;
    progressRatio: number;
    samples: number;
  } {
    const distanceM = this.#diag.distanceM;
    return {
      collisions: this.#diag.collisions,
      buildingCollisions: this.#diag.buildingCollisions,
      carCollisions: this.#diag.carCollisions,
      waterHits: this.#diag.waterHits,
      roadClamps: this.#diag.roadClamps,
      laneCorrections: this.#diag.laneCorrections,
      redLightViolations: this.#diag.redLightViolations,
      stopLineHolds: this.#diag.stopLineHolds,
      offRoadSteps: this.#diag.offRoadSteps,
      wrongWaySteps: this.#diag.wrongWaySteps,
      meanLaneError: this.#diag.samples ? this.#diag.laneErrorSum / this.#diag.samples : 0,
      distanceM,
      forwardProgressM: this.#diag.forwardProgressM,
      progressRatio: distanceM > 1e-6 ? this.#diag.forwardProgressM / distanceM : 0,
      samples: this.#diag.samples
    };
  }

  dispose(): void {
    for (const car of this.cars) {
      if (car.bodyHandle) {
        this.onWillRemoveBody(car.bodyHandle);
        this.#world.removeBody(car.bodyHandle);
      }
      car.bodyHandle = 0;
      car.tier = 0;
    }
  }

  // ------------------------------------------------------------- placement

  /** Place every car ONCE on a random road point somewhere across the city. */
  #placeAll(): void {
    if (this.#born === 0) this.#born = this.#now();
    for (const car of this.cars) this.#placeCarCityWide(car);
  }

  /**
   * Scatter one car onto a random road point anywhere in the city and give it a
   * fresh identity. Used by #placeAll and by importState for slots a restored
   * blob doesn't cover (new residents). Decoupled from the player entirely.
   */
  #placeCarCityWide(car: AiCar): void {
    let rp = this.#roads.randomPoint(this.#rng, CITY_MIN_X, CITY_MAX_X, CITY_MIN_Z, CITY_MAX_Z);
    for (let tries = 0; tries < 64; tries++) {
      if (this.#spawnClear(rp.x, rp.z, Math.atan2(rp.tangentX, rp.tangentZ), car)) break;
      rp = this.#roads.randomPoint(this.#rng, CITY_MIN_X, CITY_MAX_X, CITY_MIN_Z, CITY_MAX_Z);
    }
    this.#initCarState(car, rp.x, rp.z, Math.atan2(rp.tangentX, rp.tangentZ));
    // identity — assigned once, never rerolled
    car.bodyKind = Math.floor(this.#rng() * 6);
    car.paintHue = this.#rng();
  }

  #spawnClear(x: number, z: number, heading: number, self?: AiCar): boolean {
    if (this.#world.isWater(x, z)) return false;
    for (const other of this.cars) {
      if (other === self || !other.alive) continue;
      if (Math.hypot(other.pos.x - x, other.pos.z - z) < 10) return false;
    }
    const y = this.#world.ground(x, z) + RIDE_HEIGHT + 0.35;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const front = HALF_EXTENTS[2] + 0.35;
    const probes: [number, number][] = [
      [x, z],
      [x + fx * front, z + fz * front],
      [x - fx * front, z - fz * front]
    ];
    for (const [px, pz] of probes) {
      if (this.#world.isWater(px, pz)) return false;
      const hit = this.#world.sweep([px, y, pz], [px + fx * 0.25, y, pz + fz * 0.25]);
      if (hit != null) return false;
    }
    return true;
  }

  /** Reset a car's live state onto (x, z, heading). Body is (re)made by tiers. */
  #initCarState(car: AiCar, x: number, z: number, heading: number): void {
    car.heading = heading;
    car.speed = 0;
    car.steer = 0;
    car.prevSteer = 0;
    car.prevHeading = heading;
    car.commitSeg = -1; // re-commit travel direction on the next projection
    car.travelDir = 1;
    car.commitX = x;
    car.commitZ = z;
    car.stuckT = 0;
    car.wrongWayT = 0;
    car.carContactCooldown = 0;
    car.safeX = x;
    car.safeZ = z;
    car.safeHeading = heading;
    car.rewardAccum = 0;
    car.windowDt = 0;
    car.windowOpen = false;
    const y = this.#world.ground(x, z) + RIDE_HEIGHT;
    car.pos.set(x, y, z);
    car.prevX = x;
    car.prevZ = z;
    car.tier = 0;
    car.bodyHandle = 0;
    car.alive = true;
    car.lastObs.fill(0);
    car.learnObs.fill(0);
    car.learnAction.fill(0);
  }

  // ---------------------------------------------------------------- tiers

  #minAnchorDist2(x: number, z: number): number {
    if (this.#anchors.length === 0) return Infinity;
    let best = Infinity;
    for (const a of this.#anchors) {
      const d = (a.x - x) * (a.x - x) + (a.z - z) * (a.z - z);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Move cars between tiers with hysteresis so bodies never thrash: a body is
   * created when a car comes inside NEAR_R and destroyed only once it passes
   * FAR_R. Never moves a car — position/heading/brain are untouched.
   */
  #manageTiers(): void {
    if (this.#anchors.length === 0) return; // no anchor → leave tiers as-is
    const near2 = NEAR_R * NEAR_R;
    const far2 = FAR_R * FAR_R;
    for (const car of this.cars) {
      const d2 = this.#minAnchorDist2(car.pos.x, car.pos.z);
      if (car.tier === 0 && d2 < near2) {
        // FAR → NEAR: spin up a kinematic body at the car's current pose
        car.bodyHandle = this.#world.createBody(
          car.pos.x,
          car.pos.y,
          car.pos.z,
          HALF_EXTENTS[0],
          HALF_EXTENTS[1],
          HALF_EXTENTS[2],
          car.heading
        );
        car.tier = 1;
        this.#writeBody(car);
      } else if (car.tier === 1 && d2 > far2) {
        // NEAR → FAR: tear the body down through the release contract
        if (car.bodyHandle) {
          this.onWillRemoveBody(car.bodyHandle);
          this.#world.removeBody(car.bodyHandle);
        }
        car.bodyHandle = 0;
        car.tier = 0;
      }
    }
  }

  // ------------------------------------------------------------------- sim

  #stepCar(car: AiCar, dt: number, learnTick: boolean): void {
    const w = this.#world;
    const x = car.pos.x;
    const z = car.pos.z;
    car.carContactCooldown = Math.max(0, car.carContactCooldown - dt);
    let fwdX = Math.sin(car.heading);
    let fwdZ = Math.cos(car.heading);

    // --- road frame ---
    const proj = this.#roads.project(x, z);
    let travelX = fwdX;
    let travelZ = fwdZ;
    let lateralN = 0; // lateral / halfWidth
    let lateralRaw = 0; // signed metres from centreline (+ left)
    let halfW = 2;
    let onRoad = false;
    let sinErr = 0;
    let cosErr = 1;
    let curvature = 0;
    let dir: 1 | -1 = 1;
    let laneErr = 0;
    let wrongWay = false;
    let facingWrongWay = false;
    if (proj) {
      halfW = Math.max(2, proj.halfWidth);
      lateralRaw = proj.lateral;
      onRoad = Math.abs(proj.lateral) <= halfW;
      lateralN = THREE.MathUtils.clamp(proj.lateral / halfW, -2, 2);
      // COMMITTED travel direction, re-anchored by NET DISTANCE. The old code
      // re-picked `dir` to align with the car's heading EVERY step, so the
      // progress reward (dx·travel) was positive for ANY motion near a road — a
      // tight spin scored max reward. Committing per-segment still leaked: a fast
      // spin in dense SF roads crosses segments constantly and re-aligned `dir`
      // to its heading each time. So we only re-commit once the car has moved
      // COMMIT_DIST metres NET from where it last committed — a spin never
      // translates that far, so its `dir` stays frozen and the progress reward
      // over a circle sums to ≈0. Only genuine down-the-road travel is paid.
      if (proj.oneWayDir !== 0) {
        dir = proj.oneWayDir;
        car.travelDir = dir;
        car.commitSeg = proj.segId;
        car.commitX = x;
        car.commitZ = z;
        const oneWayAlignment = fwdX * proj.tangentX * dir + fwdZ * proj.tangentZ * dir;
        facingWrongWay = oneWayAlignment < WRONG_WAY_FACE_DOT;
        wrongWay = oneWayAlignment < WRONG_WAY_PENALTY_DOT && car.speed > 0.5;
        if (wrongWay) {
          car.heading = Math.atan2(proj.tangentX * dir, proj.tangentZ * dir);
          car.speed = 0;
          car.prevHeading = car.heading;
          car.safeHeading = car.heading;
          car.wrongWayT = 0;
          fwdX = Math.sin(car.heading);
          fwdZ = Math.cos(car.heading);
          facingWrongWay = false;
          wrongWay = false;
        }
      } else {
        const movedX = x - car.commitX;
        const movedZ = z - car.commitZ;
        const dot = fwdX * proj.tangentX + fwdZ * proj.tangentZ;
        const headingDir: 1 | -1 = dot >= 0 ? 1 : -1;
        const reversedWhileMoving = car.speed > 0.5 && headingDir !== car.travelDir && Math.abs(dot) > 0.45;
        if (car.commitSeg < 0 || movedX * movedX + movedZ * movedZ >= COMMIT_DIST * COMMIT_DIST || reversedWhileMoving) {
          car.travelDir = dot >= 0 ? 1 : -1;
          car.commitSeg = proj.segId;
          car.commitX = x;
          car.commitZ = z;
        }
        dir = car.travelDir;
      }
      travelX = proj.tangentX * dir;
      travelZ = proj.tangentZ * dir;
      if (onRoad && !w.isWater(x, z)) {
        car.safeX = x;
        car.safeZ = z;
        car.safeHeading = Math.atan2(travelX, travelZ);
      }
      const rightLaneTarget = laneCenterFor(proj, dir);
      laneErr = THREE.MathUtils.clamp((lateralRaw - rightLaneTarget) / halfW, -2, 2);
      // heading error toward a point 8 m ahead along the road
      const look = this.#roads.lookAhead(proj.segId, proj.s, dir, 8);
      const targetHeading = Math.atan2(look.x - x, look.z - z);
      const err = wrap(targetHeading - car.heading);
      sinErr = Math.sin(err);
      cosErr = Math.cos(err);
      // curvature: signed turn of the road tangent 20 m ahead
      const look2 = this.#roads.lookAhead(proj.segId, proj.s, dir, 20);
      const p2 = this.#roads.project(look2.x, look2.z);
      if (p2) {
        const d2 = travelX * p2.tangentX + travelZ * p2.tangentZ;
        const t2x = p2.tangentX * (d2 >= 0 ? 1 : -1);
        const t2z = p2.tangentZ * (d2 >= 0 ? 1 : -1);
        const cross = travelX * t2z - travelZ * t2x;
        const dd = travelX * t2x + travelZ * t2z;
        curvature = THREE.MathUtils.clamp(Math.atan2(cross, dd), -1, 1);
      }
    }

    const signal = proj
      ? this.#roads.signals.query(proj.segId, proj.s, dir, this.#timeS, SIGNAL_RANGE)
      : {
          hasSignal: false,
          signalId: -1,
          distance: SIGNAL_RANGE,
          distanceN: 1,
          state: "green" as const,
          red: 0,
          yellow: 0,
          green: 1,
          stopRequired: false
        };

    // --- clearance sensors (tier-dependent, same obs slots) ---
    let clearAhead: number;
    let clearLeft: number;
    let clearRight: number;
    if (car.tier === 1) {
      // NEAR: real building sweeps + car-vs-car cone
      clearAhead = this.#clearAhead(car, x, z, fwdX, fwdZ);
      clearLeft = this.#probe(x, z, car.pos.y, car.heading - SIDE_ANGLE, SIDE_RANGE);
      clearRight = this.#probe(x, z, car.pos.y, car.heading + SIDE_ANGLE, SIDE_RANGE);
    } else {
      // FAR: road-based estimates (documented semantics shift). Off-road cars
      // have no wall data → read fully open (offRoad penalty still teaches
      // road-keeping); on-road cars estimate from road geometry.
      if (proj) {
        // clearAhead: straight-line distance to the point AHEAD_RANGE along the
        // road. A sharp bend or a segment end that clamps short shrinks this →
        // "obstacle ahead"; a straight open road reads ≈ 1.
        const look = this.#roads.lookAhead(proj.segId, proj.s, dir, AHEAD_RANGE);
        const ddx = look.x - x;
        const ddz = look.z - z;
        clearAhead = THREE.MathUtils.clamp(Math.hypot(ddx, ddz) / AHEAD_RANGE, 0, 1);
        // clearLeft/Right: lateral margin to each road edge (+lateral = left).
        clearLeft = THREE.MathUtils.clamp((halfW - lateralRaw) / SIDE_RANGE, 0, 1);
        clearRight = THREE.MathUtils.clamp((halfW + lateralRaw) / SIDE_RANGE, 0, 1);
      } else {
        clearAhead = 1;
        clearLeft = 1;
        clearRight = 1;
      }
    }

    // --- sensors → obs (16 floats, all ~[-1,1]) ---
    const o = this.#obs;
    o[0] = car.speed / 12; // signed now (reverse reads negative)
    o[1] = lateralN;
    o[2] = sinErr;
    o[3] = cosErr;
    o[4] = curvature;
    o[5] = clearAhead;
    o[6] = clearLeft;
    o[7] = clearRight;
    o[8] = laneErr;
    o[9] = facingWrongWay ? 1 : 0;
    o[10] = signal.hasSignal ? 1 - signal.distanceN : 0;
    o[11] = signal.red;
    o[12] = signal.yellow;
    o[13] = signal.green;
    o[14] = signal.stopRequired ? 1 : 0;
    o[15] = 1;

    // --- learn tick: close the previous window on this transition ---
    // The learner wants a per-SECOND reward RATE (not the dt-integrated sum), so
    // divide the window's accumulated reward by its elapsed time.
    if (learnTick && car.windowOpen) {
      const rate = car.windowDt > 1e-9 ? car.rewardAccum / car.windowDt : 0;
      this.#learner.learnStep(car.id, car.learnObs, car.learnAction, rate, o);
      car.rewardAccum = 0;
      car.windowDt = 0;
    }

    // --- policy → sampled action (every substep, for control) ---
    this.#learner.actorForward(car.id, o, this.#action);
    const action = this.#action;
    car.lastObs.set(o); // snapshot for the brain overlay's input column
    if (facingWrongWay) car.wrongWayT += dt;
    else car.wrongWayT = 0;

    let steer = THREE.MathUtils.clamp(action[0], -1, 1);
    let accelCmd = THREE.MathUtils.clamp(action[1], -1, 1);
    if (proj) {
      const laneAssist = THREE.MathUtils.clamp(sinErr * 0.95 - laneErr * dir * 0.8 - curvature * 0.14, -1, 1);
      const laneBlend = Math.min(0.62, 0.2 + Math.abs(laneErr) * 0.22);
      steer = THREE.MathUtils.clamp(steer * (1 - laneBlend) + laneAssist * laneBlend, -1, 1);
    }
    if (clearAhead < CAR_CAUTION_CLEAR && car.speed > 0.4) {
      const obstacleM = clearAhead * AHEAD_RANGE;
      const targetSpeed = Math.max(0, (obstacleM - CAR_STOP_GAP) * 0.5);
      if (car.speed > targetSpeed) {
        accelCmd = Math.min(accelCmd, obstacleM < 8 ? -1 : -0.85);
      }
    }
    if (signal.hasSignal && signal.stopRequired && signal.distance < 32) {
      const targetSpeed = Math.max(0, (signal.distance - 3.5) * 0.38);
      if (car.speed > targetSpeed) {
        accelCmd = Math.min(accelCmd, signal.distance < 10 ? -1 : -0.75);
      }
    }
    if (facingWrongWay) {
      const desiredHeading = Math.atan2(travelX, travelZ);
      const turn = wrap(desiredHeading - car.heading);
      steer = THREE.MathUtils.clamp(steer + THREE.MathUtils.clamp(turn * 0.8, -0.65, 0.65), -1, 1);
      if (car.speed > 0.2) accelCmd = Math.min(accelCmd, -1);
      else if (car.speed < -0.2) accelCmd = Math.max(accelCmd, 0.8);
      else accelCmd = Math.min(accelCmd, 0.1);
      if (car.wrongWayT > 1.5 && Math.abs(car.speed) < 1.2) {
        car.heading = wrap(car.heading + THREE.MathUtils.clamp(turn, -2.4 * dt, 2.4 * dt));
      }
      if (car.wrongWayT > WRONG_WAY_RECOVERY_TIME) {
        car.heading = desiredHeading;
        car.speed = 0;
        steer = 0;
        accelCmd = Math.min(accelCmd, 0.1);
        car.prevHeading = car.heading;
        car.safeHeading = car.heading;
        car.wrongWayT = 0;
      }
    }

    // open a new learn window with the safety-filtered action actually executed
    if (learnTick) {
      car.learnObs.set(o);
      car.learnAction[0] = steer;
      car.learnAction[1] = accelCmd;
      car.windowOpen = true;
    }
    car.steer = steer;

    // --- integrate (kinematic bicycle, signed speed = reverse) ---
    // yaw rate ∝ signed speed → the steering geometry flips when reversing.
    const yawRate = (car.speed * Math.tan(steer * MAX_STEER_ANGLE)) / WHEELBASE;
    car.heading = wrap(car.heading + yawRate * dt);
    const accel = accelCmd >= 0 ? accelCmd * ACCEL_FWD : accelCmd * ACCEL_BRAKE;
    car.speed = THREE.MathUtils.clamp(car.speed + accel * dt, SPEED_MIN, SPEED_MAX);
    const nfx = Math.sin(car.heading);
    const nfz = Math.cos(car.heading);
    let nx = x + nfx * car.speed * dt;
    let nz = z + nfz * car.speed * dt;
    let ny = w.ground(nx, nz) + RIDE_HEIGHT;
    let hardCollision = false;
    let buildingHit = false;
    let waterHit = false;
    let waterRecovery = false;
    let carBlocked = false;
    const attemptedProgress = proj ? (nx - x) * travelX + (nz - z) * travelZ : 0;
    if (signal.hasSignal && signal.stopRequired && signal.distance <= SIGNAL_STOP_BUFFER && attemptedProgress > 0) {
      nx = x;
      nz = z;
      ny = w.ground(nx, nz) + RIDE_HEIGHT;
      car.speed = Math.min(car.speed, 0);
      this.#diag.stopLineHolds++;
    }
    if (w.isWater(nx, nz)) {
      if (proj && onRoad) {
        waterRecovery = true;
      } else {
        nx = x;
        nz = z;
        ny = w.ground(nx, nz) + RIDE_HEIGHT;
        car.speed = Math.min(car.speed, 0);
        waterHit = true;
        hardCollision = true;
      }
    } else {
      const moveLen = Math.hypot(nx - x, nz - z);
      if (moveLen > 1e-4 && (!proj || !onRoad)) {
        const front = HALF_EXTENTS[2] + 0.25;
        const sx = x + nfx * front;
        const sz = z + nfz * front;
        const ex = nx + nfx * front;
        const ez = nz + nfz * front;
        const hit = w.sweep([sx, car.pos.y + 0.35, sz], [ex, ny + 0.35, ez]);
        if (hit != null) {
          const t = THREE.MathUtils.clamp((hit - 0.5) / moveLen, 0, 1);
          nx = x + (nx - x) * t;
          nz = z + (nz - z) * t;
          ny = w.ground(nx, nz) + RIDE_HEIGHT;
          car.speed = Math.min(car.speed, 0);
          buildingHit = true;
          hardCollision = true;
        }
      }
    }
    if (!hardCollision && this.#carPathBlocked(car, nx, nz, car.heading)) {
      nx = x;
      nz = z;
      ny = w.ground(nx, nz) + RIDE_HEIGHT;
      car.speed = Math.min(car.speed, 0);
      carBlocked = true;
    }
    let recoveredToRoad = false;
    car.pos.set(nx, ny, nz);
    let roadClamp = this.#constrainToRoad(car, proj, x, z);
    let postProj = this.#roads.project(car.pos.x, car.pos.z);
    if (!postProj) {
      this.#recoverToSafeRoad(car);
      roadClamp = true;
      recoveredToRoad = true;
      postProj = this.#roads.project(car.pos.x, car.pos.z);
    }
    if (postProj?.oneWayDir) {
      const legalDir = postProj.oneWayDir;
      const legalAlignment = Math.sin(car.heading) * postProj.tangentX * legalDir + Math.cos(car.heading) * postProj.tangentZ * legalDir;
      if (legalAlignment < WRONG_WAY_PENALTY_DOT) {
        car.heading = Math.atan2(postProj.tangentX * legalDir, postProj.tangentZ * legalDir);
        car.speed = 0;
        car.prevHeading = car.heading;
        car.safeHeading = car.heading;
        car.wrongWayT = 0;
        roadClamp = true;
        recoveredToRoad = true;
      }
    }
    if (waterRecovery && !roadClamp && w.isWater(car.pos.x, car.pos.z)) {
      car.pos.set(x, w.ground(x, z) + RIDE_HEIGHT, z);
      car.speed = Math.min(car.speed, 0);
      waterHit = true;
      hardCollision = true;
    }
    if (!hardCollision && this.#carFootprintOverlaps(car, car.pos.x, car.pos.z, car.heading, 0.2, 0.4)) {
      car.pos.set(x, w.ground(x, z) + RIDE_HEIGHT, z);
      car.speed = Math.min(car.speed, 0);
      carBlocked = true;
      postProj = this.#roads.project(car.pos.x, car.pos.z);
    }
    const carHit = this.#separateCars(car);
    if (carHit) hardCollision = true;
    postProj = this.#roads.project(car.pos.x, car.pos.z);
    if (!postProj) {
      this.#recoverToSafeRoad(car);
      recoveredToRoad = true;
      postProj = this.#roads.project(car.pos.x, car.pos.z);
    }
    if (hardCollision && (waterHit || !postProj)) {
      this.#recoverToSafeRoad(car);
      recoveredToRoad = true;
    }

    // --- stuck bookkeeping (a STATE for reward, never a teleport trigger) ---
    if (Math.abs(car.speed) < STUCK_SPEED) car.stuckT += dt;
    else car.stuckT = 0;

    // --- shaped reward (per plan; per-second rates × dt) ---
    const dx = car.pos.x - car.prevX;
    const dz = car.pos.z - car.prevZ;
    const ds = recoveredToRoad ? 0 : Math.hypot(dx, dz);
    const progress = proj && !recoveredToRoad ? dx * travelX + dz * travelZ : 0;
    this.#diag.distanceM += ds;
    this.#diag.forwardProgressM += progress;
    // Progress is only credited against a real road tangent. With no projection
    // travel*=heading, so crediting dx·travel would pay raw heading speed for
    // driving into the void — zero it (the penalties below still apply).
    let r = progress; // forward progress along road (m)
    if (!onRoad) {
      r -= R_OFFROAD * dt;
      this.#diag.offRoadSteps++;
    }
    r -= R_LANE * Math.min(2, Math.abs(laneErr)) * dt;
    this.#diag.laneErrorSum += Math.abs(laneErr);
    this.#diag.samples++;
    if (wrongWay) {
      r -= R_WRONG_WAY * dt;
      this.#diag.wrongWaySteps++;
    }
    if (clearAhead < 0.08 && Math.abs(car.speed) > 1) r -= R_GRIND * dt; // grinding
    if (clearAhead < 0.28 && car.speed > 2) r -= R_CLOSE_FOLLOW * (0.28 - clearAhead) * dt;
    if (carBlocked) r -= R_CLOSE_FOLLOW * dt;
    if (roadClamp) {
      r -= R_ROAD_CLAMP * dt;
    }
    if (hardCollision) {
      r -= R_COLLISION;
      this.#diag.collisions++;
      if (buildingHit) this.#diag.buildingCollisions++;
      if (carHit) this.#diag.carCollisions++;
      if (waterHit) this.#diag.waterHits++;
    }
    if (signal.hasSignal && signal.stopRequired) {
      if (signal.distance < 22 && car.speed > 0.4) r -= R_RED_APPROACH * car.speed * (1 - signal.distanceN) * dt;
      if (signal.red && signal.distance < 1.5 && progress > 0.05 && car.speed > 1) {
        r -= R_RED_LIGHT;
        this.#diag.redLightViolations++;
      }
    }
    // steer smoothness: penalise change in steer command (jerk)
    const steerRate = (steer - car.prevSteer) / dt;
    r -= R_STEER * Math.abs(steerRate) * dt;
    if (car.speed < -0.1) r -= R_REVERSE * dt; // reversing is a tool, not a lifestyle
    if (car.stuckT > STUCK_TIME) r -= R_STUCK * dt; // wedged
    // sustained yaw: |heading change| this step (a spin bleeds reward continuously)
    r -= R_YAW * Math.abs(wrap(car.heading - car.prevHeading));
    car.prevHeading = car.heading;
    car.rewardAccum += r;
    car.windowDt += dt;

    // odometer (distance travelled, either direction)
    this.#learner.addOdometer(car.id, ds);

    car.prevSteer = steer;
    car.prevX = car.pos.x;
    car.prevZ = car.pos.z;

    this.#writeBody(car);
  }

  #recoverToSafeRoad(car: AiCar): void {
    const safeProj = this.#roads.project(car.safeX, car.safeZ);
    if (!safeProj) {
      this.#forceRoadPose(car);
      return;
    }
    car.pos.set(car.safeX, this.#world.ground(car.safeX, car.safeZ) + RIDE_HEIGHT, car.safeZ);
    car.heading = car.safeHeading;
    car.speed = 0;
    car.prevHeading = car.heading;
    car.prevX = car.pos.x;
    car.prevZ = car.pos.z;
    car.commitSeg = -1;
    car.commitX = car.pos.x;
    car.commitZ = car.pos.z;
    car.stuckT = 0;
    car.wrongWayT = 0;
  }

  /** clearAhead: building sweep raced against the nearest car in a forward cone. */
  #clearAhead(car: AiCar, x: number, z: number, fwdX: number, fwdZ: number): number {
    let clear = this.#probe(x, z, car.pos.y, car.heading, AHEAD_RANGE);
    // nearest other car ahead within the range and a narrow lateral band
    for (const other of this.cars) {
      if (other === car) continue;
      const ox = other.pos.x - x;
      const oz = other.pos.z - z;
      const along = ox * fwdX + oz * fwdZ;
      const d = Math.hypot(ox, oz);
      if (along > AHEAD_RANGE || (along <= 0 && d >= 12)) continue;
      const side = Math.abs(ox * fwdZ - oz * fwdX); // perpendicular offset
      if (side > CAR_BRAKE_SIDE && !(d < 12 && along > -1.5)) continue;
      const c = Math.max(0, Math.min(along, d)) / AHEAD_RANGE;
      if (c < clear) clear = c;
    }
    return clear;
  }

  #carPathBlocked(car: AiCar, x: number, z: number, heading: number): boolean {
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    for (const other of this.cars) {
      if (other === car) continue;
      const dx = other.pos.x - x;
      const dz = other.pos.z - z;
      const ahead = dx * fwdX + dz * fwdZ;
      if (ahead < -CAR_FOOTPRINT_ALONG * 0.45 || ahead > CAR_BRAKE_ALONG * 1.35) continue;
      const side = Math.abs(dx * fwdZ - dz * fwdX);
      if (side > CAR_BRAKE_SIDE) continue;
      return true;
    }
    return false;
  }

  #carFootprintOverlaps(car: AiCar, x: number, z: number, heading: number, sidePad = 0, alongPad = 0): boolean {
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    const rightX = fwdZ;
    const rightZ = -fwdX;
    for (const other of this.cars) {
      if (other === car) continue;
      const dx = x - other.pos.x;
      const dz = z - other.pos.z;
      const along = dx * fwdX + dz * fwdZ;
      if (Math.abs(along) >= CAR_FOOTPRINT_ALONG + alongPad) continue;
      const side = dx * rightX + dz * rightZ;
      if (Math.abs(side) >= CAR_FOOTPRINT_SIDE + sidePad) continue;
      return true;
    }
    return false;
  }

  /** Resolve simple car-vs-car overlap in the authoritative kinematic state. */
  #separateCars(car: AiCar): boolean {
    let hit = false;
    const fwdX = Math.sin(car.heading);
    const fwdZ = Math.cos(car.heading);
    const rightX = fwdZ;
    const rightZ = -fwdX;
    for (const other of this.cars) {
      if (other === car) continue;
      const dx = car.pos.x - other.pos.x;
      const dz = car.pos.z - other.pos.z;
      const along = dx * fwdX + dz * fwdZ;
      const side = dx * rightX + dz * rightZ;
      const alongOverlap = CAR_FOOTPRINT_ALONG - Math.abs(along);
      if (alongOverlap <= 0) continue;
      const sideOverlap = CAR_FOOTPRINT_SIDE - Math.abs(side);
      if (sideOverlap <= 0) continue;
      if (
        Math.abs(along) < CAR_HARD_ALONG &&
        Math.abs(side) < CAR_HARD_SIDE &&
        car.carContactCooldown <= 0 &&
        other.carContactCooldown <= 0
      ) {
        hit = true;
        car.carContactCooldown = CAR_CONTACT_COOLDOWN;
        other.carContactCooldown = CAR_CONTACT_COOLDOWN;
      }
      let pushX: number;
      let pushZ: number;
      if (sideOverlap < alongOverlap) {
        const sign = side >= 0 ? 1 : -1;
        pushX = rightX * sign * (sideOverlap + 0.16);
        pushZ = rightZ * sign * (sideOverlap + 0.16);
      } else {
        const sign = along >= 0 ? 1 : -1;
        pushX = fwdX * sign * (alongOverlap + 0.24);
        pushZ = fwdZ * sign * (alongOverlap + 0.24);
      }
      car.pos.x += pushX * 0.55;
      car.pos.z += pushZ * 0.55;
      other.pos.x -= pushX * 0.45;
      other.pos.z -= pushZ * 0.45;
      car.pos.y = this.#world.ground(car.pos.x, car.pos.z) + RIDE_HEIGHT;
      other.pos.y = this.#world.ground(other.pos.x, other.pos.z) + RIDE_HEIGHT;
      car.speed *= 0.25;
      other.speed *= 0.35;
      this.#constrainToRoad(other, this.#roads.project(other.pos.x, other.pos.z), other.prevX, other.prevZ);
      this.#ensureRoadProjected(other);
      other.prevX = other.pos.x;
      other.prevZ = other.pos.z;
      this.#writeBody(other);
    }
    return hit;
  }

  #settleCarPairs(): void {
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j];
        let dx = a.pos.x - b.pos.x;
        let dz = a.pos.z - b.pos.z;
        let d2 = dx * dx + dz * dz;
        if (d2 >= CAR_SETTLE_DIST2) continue;
        if (d2 < 1e-6) {
          dx = Math.sin(a.heading + Math.PI * 0.5);
          dz = Math.cos(a.heading + Math.PI * 0.5);
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const push = (CAR_SETTLE_DIST - d) / d;
        const px = dx * push * 0.5;
        const pz = dz * push * 0.5;
        a.pos.x += px;
        a.pos.z += pz;
        b.pos.x -= px;
        b.pos.z -= pz;
        a.speed *= 0.55;
        b.speed *= 0.55;
        this.#constrainToRoad(a, this.#roads.project(a.pos.x, a.pos.z), a.prevX, a.prevZ);
        this.#constrainToRoad(b, this.#roads.project(b.pos.x, b.pos.z), b.prevX, b.prevZ);
        for (const car of [a, b]) {
          this.#ensureRoadProjected(car);
          car.pos.y = this.#world.ground(car.pos.x, car.pos.z) + RIDE_HEIGHT;
          car.prevX = car.pos.x;
          car.prevZ = car.pos.z;
          this.#writeBody(car);
        }
      }
    }
  }

  /** Keep failed policies from disappearing into buildings/blocks forever. */
  #constrainToRoad(car: AiCar, proj: Projection | null, baseX: number, baseZ: number): boolean {
    const liveProj = this.#roads.project(car.pos.x, car.pos.z);
    const activeProj = liveProj ?? proj;
    if (!activeProj) {
      const changed = this.#forceRoadPose(car, baseX, baseZ);
      if (changed) this.#diag.roadClamps++;
      return changed;
    }
    const edge = Math.max(1.2, activeProj.halfWidth * ROAD_EDGE_FRACTION);
    const clampEdge = Math.max(0.8, edge - 0.15);
    const wet = this.#world.isWater(car.pos.x, car.pos.z);

    const nx = -activeProj.tangentZ;
    const nz = activeProj.tangentX;
    const lateral = liveProj
      ? liveProj.lateral
      : (car.pos.x - (baseX - nx * activeProj.lateral)) * nx + (car.pos.z - (baseZ - nz * activeProj.lateral)) * nz;
    const centerX = liveProj ? car.pos.x - nx * lateral : baseX - nx * activeProj.lateral;
    const centerZ = liveProj ? car.pos.z - nz * lateral : baseZ - nz * activeProj.lateral;
    const headingDot = Math.sin(car.heading) * activeProj.tangentX + Math.cos(car.heading) * activeProj.tangentZ;
    const dir =
      activeProj.oneWayDir ||
      (car.speed > 0.5 && Math.abs(headingDot) > 0.45 ? (headingDot >= 0 ? 1 : -1) : car.travelDir);
    if (activeProj.oneWayDir === 0) car.travelDir = dir;
    const rightLane = THREE.MathUtils.clamp(laneCenterFor(activeProj, dir), -clampEdge, clampEdge);
    const centerlineGrace = Math.max(0.45, Math.min(1.4, activeProj.halfWidth * 0.18));
    const enforceSide = Math.abs(car.speed) > 0.35 && Math.abs(headingDot) > 0.45;
    const wrongSide =
      enforceSide &&
      activeProj.oneWayDir === 0 &&
      ((dir === 1 && lateral > centerlineGrace) || (dir === -1 && lateral < -centerlineGrace));
    const offEdge = Math.abs(lateral) > edge;
    if (!offEdge && !wet && !wrongSide) return false;

    if (wet || offEdge) this.#diag.roadClamps++;
    else this.#diag.laneCorrections++;

    let clamped = THREE.MathUtils.clamp(lateral, -clampEdge, clampEdge);
    if (wet) {
      const candidates = [clamped, rightLane, 0, -clampEdge * 0.5, clampEdge * 0.5, -clampEdge, clampEdge];
      for (const candidate of candidates) {
        const tx = centerX + nx * candidate;
        const tz = centerZ + nz * candidate;
        if (!this.#world.isWater(tx, tz)) {
          clamped = candidate;
          break;
        }
      }
    } else {
      const tx = centerX + nx * rightLane;
      const tz = centerZ + nz * rightLane;
      if (!this.#world.isWater(tx, tz)) clamped = rightLane;
    }
    car.pos.x = centerX + nx * clamped;
    car.pos.z = centerZ + nz * clamped;
    car.pos.y = this.#world.ground(car.pos.x, car.pos.z) + RIDE_HEIGHT;
    car.speed *= ROAD_RECOVERY_SPEED_DAMP;
    return true;
  }

  #ensureRoadProjected(car: AiCar): boolean {
    const proj = this.#roads.project(car.pos.x, car.pos.z);
    if (proj && !this.#world.isWater(car.pos.x, car.pos.z)) return false;
    const changed = this.#forceRoadPose(car);
    if (changed) {
      this.#diag.roadClamps++;
      this.#writeBody(car);
    }
    return changed;
  }

  #forceRoadPose(car: AiCar, aroundX = car.pos.x, aroundZ = car.pos.z): boolean {
    let x = aroundX;
    let z = aroundZ;
    let proj = this.#roads.project(x, z);
    if (!proj) {
      const near = this.#roads.randomPointNear(x, z, 0, 260, this.#rng);
      const rp = near ?? this.#roads.randomPoint(this.#rng, CITY_MIN_X, CITY_MAX_X, CITY_MIN_Z, CITY_MAX_Z);
      x = rp.x;
      z = rp.z;
      proj = this.#roads.project(x, z);
    }
    if (!proj) return false;

    const nx = -proj.tangentZ;
    const nz = proj.tangentX;
    const centerX = x - nx * proj.lateral;
    const centerZ = z - nz * proj.lateral;
    const headingDot = Math.sin(car.heading) * proj.tangentX + Math.cos(car.heading) * proj.tangentZ;
    const dir: 1 | -1 = proj.oneWayDir || (Number.isFinite(headingDot) && headingDot < 0 ? -1 : 1);
    const edge = Math.max(1.2, proj.halfWidth * ROAD_EDGE_FRACTION);
    const lane = THREE.MathUtils.clamp(laneCenterFor(proj, dir), -edge, edge);
    const candidates = [lane, 0, -edge * 0.5, edge * 0.5, -edge, edge];
    let lateral = lane;
    for (const candidate of candidates) {
      const tx = centerX + nx * candidate;
      const tz = centerZ + nz * candidate;
      if (!this.#world.isWater(tx, tz)) {
        lateral = candidate;
        break;
      }
    }

    car.pos.set(centerX + nx * lateral, this.#world.ground(centerX + nx * lateral, centerZ + nz * lateral) + RIDE_HEIGHT, centerZ + nz * lateral);
    car.heading = Math.atan2(proj.tangentX * dir, proj.tangentZ * dir);
    car.speed = 0;
    car.prevHeading = car.heading;
    car.prevX = car.pos.x;
    car.prevZ = car.pos.z;
    car.safeX = car.pos.x;
    car.safeZ = car.pos.z;
    car.safeHeading = car.heading;
    car.travelDir = dir;
    car.commitSeg = -1;
    car.commitX = car.pos.x;
    car.commitZ = car.pos.z;
    car.stuckT = 0;
    car.wrongWayT = 0;
    return true;
  }

  /** One directional clearance probe in [0,1]: water ahead reads as blocked. */
  #probe(x: number, z: number, y: number, heading: number, range: number): number {
    const ex = Math.sin(heading);
    const ez = Math.cos(heading);
    const fx = x + ex * range;
    const fz = z + ez * range;
    if (this.#world.isWater(fx, fz)) return 0;
    const py = y + 0.4;
    const start = 1.5;
    const hit = this.#world.sweep([x + ex * start, py, z + ez * start], [fx, py, fz]);
    if (hit != null) return THREE.MathUtils.clamp((hit + start) / range, 0, 1);
    return 1;
  }

  /** Push the car's pose into its kinematic body (yaw owned, tilt on the ground). */
  #writeBody(car: AiCar): void {
    if (!car.bodyHandle) return;
    // ground normal from finite differences of the injected height field
    const e = 2.5;
    const x = car.pos.x;
    const z = car.pos.z;
    const w = this.#world;
    this.#nrm
      .set(w.ground(x - e, z) - w.ground(x + e, z), 2 * e, w.ground(x, z - e) - w.ground(x, z + e))
      .normalize();
    this.#qYaw.setFromAxisAngle(this.#up, car.heading);
    this.#qTilt.setFromUnitVectors(this.#up, this.#nrm).multiply(this.#qYaw);
    const q = this.#qTilt;
    this.#world.moveBody(car.bodyHandle, x, car.pos.y, z, q.x, q.y, q.z, q.w);
  }

  // ----------------------------------------------------------- persistence

  #now(): number {
    return typeof Date !== "undefined" ? Date.now() : 0;
  }

  /**
   * Snapshot every car as a persistable blob: the learner's per-car brain fields
   * merged with the fleet-owned identity + position. Positions persist too — a
   * restored car is WHERE IT WAS.
   */
  exportState(): FleetBlob {
    const cars: CarBlob[] = [];
    for (const car of this.cars) {
      this.#ensureRoadProjected(car);
      const brain = this.#learner.exportCar(car.id);
      cars.push({
        ...brain,
        id: car.id,
        bodyKind: car.bodyKind,
        paintHue: car.paintHue,
        x: car.pos.x,
        z: car.pos.z,
        heading: car.heading,
        speed: car.speed
      });
    }
    return { v: 3, born: this.#born || this.#now(), cars };
  }

  /**
   * Restore identities, positions, and brains from a blob. Validates the shape
   * first (returns false, applying nothing, on any bad field) so a poisoned blob
   * can't half-load. Existing bodies are released through onWillRemoveBody; new
   * bodies are created lazily by the tier manager on the next prePhysics.
   */
  importState(blob: FleetBlob | null | undefined): boolean {
    if (!blob || blob.v !== 3 || !Array.isArray(blob.cars) || blob.cars.length === 0) return false;
    const n = Math.min(blob.cars.length, this.cars.length);
    // validate every entry we intend to apply before touching any state
    for (let i = 0; i < n; i++) {
      const c = blob.cars[i];
      if (!c || typeof c !== "object") return false;
      if (!Number.isInteger(c.id) || c.id < 0 || c.id >= this.cars.length) return false;
      if (!Number.isFinite(c.x) || !Number.isFinite(c.z) || !Number.isFinite(c.heading)) return false;
      if (c.speed != null && !Number.isFinite(c.speed)) return false;
      if (!Number.isFinite(c.bodyKind) || !Number.isFinite(c.paintHue)) return false;
    }
    // tear down existing bodies (fires the release contract) before repositioning
    this.dispose();
    const covered = new Array<boolean>(this.cars.length).fill(false);
    for (let i = 0; i < n; i++) {
      const c = blob.cars[i];
      const car = this.cars[c.id];
      car.bodyKind = Math.floor(c.bodyKind) & 255;
      car.paintHue = THREE.MathUtils.clamp(c.paintHue, 0, 1);
      this.#initCarState(car, c.x, c.z, c.heading);
      this.#ensureRoadProjected(car);
      this.#learner.importCar(car.id, c);
      covered[c.id] = true;
    }
    // Slots the blob doesn't cover (partial cache / short saved array) must NOT
    // be stranded alive=false at (0,0,0): scatter each city-wide as a fresh
    // resident with fresh learner weights.
    for (const car of this.cars) {
      if (covered[car.id]) continue;
      this.#placeCarCityWide(car);
      this.#learner.resetCar(car.id);
    }
    this.#born = typeof blob.born === "number" && Number.isFinite(blob.born) ? blob.born : this.#now();
    this.#initialized = true;
    return true;
  }
}
