import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { WorldMap } from "../../world/heightmap";
import type { GolfCourse, GolfSurface } from "./data";

/**
 * Golf ball flight + short game, kinematic like the paintballs: no physics
 * body, a swept integrate against the golf-aware ground (flattened greens),
 * the static world (buildings — fronting Presidio's clubhouse counts) and
 * water. Deterministic given the same inputs, but only the OWNER simulates —
 * remote balls just replay position snapshots, so clients can never diverge.
 *
 * Three phases: FLY (ballistic + drag), ROLL (slope + surface friction on the
 * golf ground), REST. The cup captures a slow roller inside its radius.
 */

export const BALL_RADIUS = 0.055;

export type ClubId = "driver" | "wood3" | "iron3" | "iron5" | "iron7" | "iron9" | "wedge" | "sand" | "putter";

export type Club = {
  id: ClubId;
  label: string;
  short: string;
  /** full-power launch speed (m/s) — calibrated so flat carry hits `carry`. */
  speed: number;
  /** launch angle above horizon (rad) */
  loft: number;
  /** advertised full carry in meters (UI + club auto-suggest) */
  carry: number;
  /** how hard the ball checks up on landing (kills forward roll) 0..1 */
  bite: number;
};

// speeds calibrated against this integrator (tools/calibrate-golf.mjs)
export const CLUBS: Club[] = [
  { id: "driver", label: "Driver", short: "DR", speed: 79.9, loft: 0.24, carry: 230, bite: 0.1 },
  { id: "wood3", label: "3 Wood", short: "3W", speed: 68.2, loft: 0.28, carry: 200, bite: 0.15 },
  { id: "iron3", label: "3 Iron", short: "3i", speed: 57.9, loft: 0.34, carry: 175, bite: 0.22 },
  { id: "iron5", label: "5 Iron", short: "5i", speed: 49.5, loft: 0.42, carry: 155, bite: 0.3 },
  { id: "iron7", label: "7 Iron", short: "7i", speed: 40.7, loft: 0.56, carry: 130, bite: 0.42 },
  { id: "iron9", label: "9 Iron", short: "9i", speed: 34.5, loft: 0.7, carry: 105, bite: 0.55 },
  { id: "wedge", label: "P Wedge", short: "PW", speed: 29.1, loft: 0.91, carry: 75, bite: 0.7 },
  { id: "sand", label: "S Wedge", short: "SW", speed: 25.5, loft: 1.01, carry: 55, bite: 0.8 },
  // Rolling distance on a flat green is v²/(2µ): 6.63 m/s at µ=.55 ≈ 40 m.
  { id: "putter", label: "Putter", short: "PT", speed: 6.63, loft: 0, carry: 40, bite: 0 }
];

const GRAVITY = 9.81;
const DRAG = 0.0016; // quadratic air drag (1/m) — mild, speeds are pre-calibrated
const SUBSTEP = 1 / 120;
const carryCache = new Map<string, number>();

/** Strike quality multiplier when swinging OFF the short stuff. */
export function lieFactor(kind: GolfSurface, club: Club): number {
  if (kind === "bunker") return club.id === "sand" ? 0.85 : 0.4;
  if (kind === "rough" || kind === "out") return club.id === "sand" || club.id === "wedge" ? 0.85 : 0.65;
  return 1;
}

/** Flat-ground distance estimate for the radial HUD. Lofted shots run the same
 *  120 Hz drag/gravity integrator as flight, cached at 1% power increments; a
 *  rolling putt follows the exact v² relationship. */
export function estimatedCarry(club: Club, power: number, lie: GolfSurface): number {
  const effectivePower = Math.round(THREE.MathUtils.clamp(power * lieFactor(lie, club), 0, 1) * 100) / 100;
  if (club.id === "putter") return club.carry * effectivePower * effectivePower;
  const key = `${club.id}:${effectivePower}`;
  const cached = carryCache.get(key);
  if (cached !== undefined) return cached;

  let x = 0;
  let y = 0.02; // strike() lifts a flying ball 2 cm above contact
  let vx = Math.cos(club.loft) * club.speed * effectivePower;
  let vy = Math.sin(club.loft) * club.speed * effectivePower;
  for (let i = 0; i < 60 / SUBSTEP; i++) {
    const speed = Math.hypot(vx, vy);
    const k = 1 - Math.min(0.9, DRAG * speed * SUBSTEP);
    vx *= k;
    vy = vy * k - GRAVITY * SUBSTEP;
    x += vx * SUBSTEP;
    y += vy * SUBSTEP;
    if (y <= 0) break;
  }
  carryCache.set(key, x);
  return x;
}

/** Auto-caddie: specialized short-game clubs first, otherwise the shortest
 *  normal club whose full-power carry from the current lie clears the pin. */
export function suggestedClubIndex(distance: number, lie: GolfSurface): number {
  if (lie === "green") return CLUBS.length - 1;
  if (lie === "bunker") return CLUBS.findIndex((c) => c.id === "sand");
  if (distance < 30) return CLUBS.findIndex((c) => c.id === "wedge");
  for (let i = CLUBS.length - 3; i >= 0; i--) {
    if (estimatedCarry(CLUBS[i], 1, lie) >= distance * 1.02) return i;
  }
  return 0;
}

type SurfaceParams = { restitution: number; grip: number; mu: number };
const SURFACE: Record<GolfSurface, SurfaceParams> = {
  green: { restitution: 0.32, grip: 0.3, mu: 0.55 },
  tee: { restitution: 0.34, grip: 0.32, mu: 0.9 },
  fairway: { restitution: 0.3, grip: 0.38, mu: 1.4 },
  path: { restitution: 0.52, grip: 0.15, mu: 1.0 },
  rough: { restitution: 0.14, grip: 0.62, mu: 4.6 },
  bunker: { restitution: 0.04, grip: 0.92, mu: 8.5 },
  out: { restitution: 0.14, grip: 0.62, mu: 5.5 }
};

const CUP_RADIUS = 0.16; // forgiving arcade cup
const CUP_SPEED = 2.6; // faster than this lips out
const STOP_SPEED = 0.14;

export type BallPhase = "fly" | "roll" | "rest" | "holed";

export type BallEvent =
  | { kind: "land"; surface: GolfSurface }
  | { kind: "holed" }
  | { kind: "water"; x: number; z: number }
  | { kind: "rest"; surface: GolfSurface };

export class GolfBall {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  phase: BallPhase = "rest";
  /** set while a shot is being tracked */
  onEvent: (e: BallEvent) => void = () => {};

  #course: GolfCourse;
  #map: WorldMap;
  #physics: Physics;
  #pin = new THREE.Vector3();
  #n = new THREE.Vector3();
  #tmp = new THREE.Vector3();
  #dir = new THREE.Vector3();
  #bite = 0;
  #bounces = 0;
  #airTime = 0;

  constructor(course: GolfCourse, map: WorldMap, physics: Physics) {
    this.#course = course;
    this.#map = map;
    this.#physics = physics;
  }

  get moving(): boolean {
    return this.phase === "fly" || this.phase === "roll";
  }

  place(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.phase = "rest";
  }

  /** Strike toward `yaw` (heading, atan2(x,z)) with `power` 0..1. */
  strike(club: Club, yaw: number, power: number, lie: GolfSurface, pin: THREE.Vector3) {
    this.#pin.copy(pin);
    const v = club.speed * Math.max(0.06, power) * lieFactor(lie, club);
    const cosL = Math.cos(club.loft);
    this.vel.set(Math.sin(yaw) * v * cosL, Math.sin(club.loft) * v, Math.cos(yaw) * v * cosL);
    this.#bite = club.bite;
    this.#bounces = 0;
    this.#airTime = 0;
    this.phase = club.id === "putter" ? "roll" : "fly";
    if (this.phase === "fly") this.pos.y += 0.02;
  }

  update(dt: number) {
    if (!this.moving) return;
    let t = Math.min(dt, 0.1);
    while (t > 0 && this.moving) {
      const h = Math.min(SUBSTEP, t);
      t -= h;
      if (this.phase === "fly") this.#fly(h);
      else this.#roll(h);
    }
  }

  #groundAt(x: number, z: number): number {
    return this.#course.ground(x, z);
  }

  #fly(h: number) {
    this.#airTime += h;
    const v = this.vel;
    const speed = v.length();
    // quadratic drag
    const k = 1 - Math.min(0.9, DRAG * speed * h);
    v.multiplyScalar(k);
    v.y -= GRAVITY * h;

    const step = this.#tmp.copy(v).multiplyScalar(h);
    const stepLen = step.length();
    // buildings/bridges first (clubhouse, anyone slicing onto Doyle Drive)
    if (stepLen > 1e-6 && this.#airTime > 0.06) {
      this.#dir.copy(step).divideScalar(stepLen);
      const hit = this.#physics.raycastWorld(this.pos, this.#dir, stepLen + BALL_RADIUS);
      if (hit && hit.kind === "building") {
        this.pos.copy(hit.point).addScaledVector(hit.normal, BALL_RADIUS + 0.01);
        const vn = v.dot(hit.normal);
        v.addScaledVector(hit.normal, -1.6 * vn); // restitution 0.6 off walls
        v.multiplyScalar(0.75);
        return;
      }
    }

    const next = this.#tmp.copy(this.pos).add(step);
    const ground = this.#groundAt(next.x, next.z) + BALL_RADIUS;
    if (next.y > ground) {
      this.pos.copy(next);
      return;
    }

    // crossed the ground this substep — bisect to the contact point
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 4; i++) {
      const mid = (lo + hi) / 2;
      const px = this.pos.x + step.x * mid;
      const pz = this.pos.z + step.z * mid;
      const py = this.pos.y + step.y * mid;
      if (py > this.#groundAt(px, pz) + BALL_RADIUS) lo = mid;
      else hi = mid;
    }
    this.pos.addScaledVector(step, lo);
    this.pos.y = this.#groundAt(this.pos.x, this.pos.z) + BALL_RADIUS;

    if (this.#map.isWater(this.pos.x, this.pos.z)) {
      this.phase = "rest";
      this.vel.set(0, 0, 0);
      this.onEvent({ kind: "water", x: this.pos.x, z: this.pos.z });
      return;
    }

    const surf = this.#course.surfaceAt(this.pos.x, this.pos.z);
    const params = SURFACE[surf.kind];
    this.#course.groundNormal(this.pos.x, this.pos.z, this.#n);
    if (this.#bounces === 0) this.onEvent({ kind: "land", surface: surf.kind });
    this.#bounces++;

    const vn = v.dot(this.#n);
    // reflect + damp: normal by restitution, tangent by grip (+ spin bite on first hit)
    v.addScaledVector(this.#n, -vn); // tangential part
    const gripLoss = params.grip + (this.#bounces === 1 ? this.#bite * 0.5 : 0);
    v.multiplyScalar(Math.max(0, 1 - gripLoss));
    v.addScaledVector(this.#n, -vn * params.restitution);

    if (v.y < 1.1 && Math.abs(vn) < 3.2) {
      v.y = 0;
      this.phase = "roll";
    }
  }

  #roll(h: number) {
    const v = this.vel;
    const p = this.pos;
    const surf = this.#course.surfaceAt(p.x, p.z);
    const params = SURFACE[surf.kind];
    this.#course.groundNormal(p.x, p.z, this.#n);
    const n = this.#n;

    // gravity along the surface (downhill pull — this is what breaks putts):
    // g_t = g - (g·n)n with g=(0,-G,0) → horizontal parts G·ny·nx, G·ny·nz
    v.x += GRAVITY * n.y * n.x * h;
    v.z += GRAVITY * n.y * n.z * h;

    // rolling friction against the velocity
    const sp = Math.hypot(v.x, v.z);
    if (sp > 1e-4) {
      const dec = params.mu * h;
      const f = Math.max(0, sp - dec) / sp;
      v.x *= f;
      v.z *= f;
    }
    v.y = 0;

    p.x += v.x * h;
    p.z += v.z * h;
    p.y = this.#groundAt(p.x, p.z) + BALL_RADIUS;

    if (this.#map.isWater(p.x, p.z)) {
      this.phase = "rest";
      v.set(0, 0, 0);
      this.onEvent({ kind: "water", x: p.x, z: p.z });
      return;
    }

    // cup capture — inside the radius and slow enough to drop
    const dPin = Math.hypot(p.x - this.#pin.x, p.z - this.#pin.z);
    const speed = Math.hypot(v.x, v.z);
    if (dPin < CUP_RADIUS && speed < CUP_SPEED && Math.abs(p.y - this.#pin.y) < 0.6) {
      this.phase = "holed";
      p.set(this.#pin.x, this.#pin.y - 0.06, this.#pin.z);
      v.set(0, 0, 0);
      this.onEvent({ kind: "holed" });
      return;
    }

    const slope = Math.hypot(n.x, n.z);
    if (speed < STOP_SPEED && slope < 0.12) {
      v.set(0, 0, 0);
      this.phase = "rest";
      this.onEvent({ kind: "rest", surface: surf.kind });
    }
  }
}
