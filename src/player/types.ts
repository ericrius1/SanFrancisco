import type * as THREE from "three/webgpu";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";
import type { Input } from "../core/input";

export type PlayerMode = "walk" | "drive" | "plane" | "boat" | "speedboat" | "drone" | "board" | "bird";

/** Where the driver rig + steering wheel sit inside a drive mesh (mesh-local). */
export type Cockpit = {
  seat: [number, number, number];
  wheel?: [number, number, number];
  hide?: boolean; // closed cab — rig would poke through the roof
};

/** Body + handling of whatever the player is currently driving (default sports
 * car, or a ridden animal — factors scale the drive tunables). */
export type DriveSpec = {
  halfExtents: [number, number, number];
  rideHeight: number;
  maxFactor: number;
  accelFactor: number;
  steerFactor: number;
};

export const DEFAULT_DRIVE_SPEC: DriveSpec = {
  halfExtents: [1.15, 0.45, 2.3],
  rideHeight: 0.85,
  maxFactor: 1,
  accelFactor: 1,
  steerFactor: 1
};

/**
 * What a mode controller sees of the player. Structurally satisfied by Player
 * itself — controllers mutate position/heading/quaternion through it and drive
 * the physics body via ctx.physics.world.
 */
export interface PlayerCtx {
  readonly physics: Physics;
  readonly map: WorldMap;
  body: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  speed: number;
  heading: number; // storage convention: facing + π
  time: number; // sim seconds, advanced by fixed steps
  driveSpec: DriveSpec;
  /** Set before switching to walk from a water vehicle exit — skip the shore hop. */
  swimEnter?: boolean;
}

export type BodyVel = { linear: number[]; angular: number[] };

/** Per-step data the player hands each controller alongside the input. */
export type ModeFrame = {
  camYaw: number;
  aim: THREE.Vector3; // camera look direction (drone flies along it)
  v: BodyVel; // body velocity read at the start of the step
};

/**
 * One embodiment's behavior. Implementations own all their per-mode state
 * (carve yaw, jump buffers, smoothed steering…) and reset it in spawnBody.
 * Adding a new vehicle = implement this in its own folder under src/vehicles/
 * and register it in Player's controller table.
 */
export interface ModeController {
  /**
   * Create this mode's physics body at ctx.position, nosing toward the raw
   * yaw `facing`; reset per-mode state. Returns the Y the body was placed at
   * (Player rewrites the transform there and seeds render interpolation).
   */
  spawnBody(ctx: PlayerCtx, facing: number): number;
  /** Y that spawnBody lifts the body by — restoreState pre-subtracts it so a
   * session refresh doesn't creep the player upward. */
  readonly spawnLift: number;
  /** Adjust entry position when switching INTO this mode (altitude pushes,
   * shore hops). Keeps the previous mode's XZ — aerial modes only raise Y.
   * May return a facing override. */
  enter?(ctx: PlayerCtx): number | void;
  /** One fixed physics step of control. */
  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame): void;
}
